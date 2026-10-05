
SELECT
	cmd.Name	
	--,substr(cb.Bonuses,1,24)
	,cb.CommanderID
	,CASE
		when cmd.CommanderType = 0 then 'Naval'
		when cmd.CommanderType = 1 then 'Ground Force Commander'
		when cmd.CommanderType = 2 then 'Civilian Administrator'
		when cmd.CommanderType = 3 then 'Scientist'
		else 'Unknown CommanderType: ' || cmd.CommanderType
	end as CmdType
	,cb.Bonuses
	,substr(cb.Bonuses,27)
--	,group_concat('' || t.Name	, ', ') as Traits
	--,*
FROM
	vw_const as c
inner join
	FCT_Commander as cmd
on
	cmd.RaceID = c.RaceId
left join
(
	SELECT
		cb.CommanderID
		,group_concat('' || bt.Description 
		|| ': ' 
		|| case when cb.BonusID in (25,27) then cast(cb.BonusValue as int) else cast((100*(cb.BonusValue-1))+.01 as int)end 	-- don't ask about the +.01 part. SQLite is just weird with floating point values.
		|| case when cb.BonusID in (25,27) then '' else '%' end
		, ', ') as Bonuses	
	from
		FCT_CommanderBonuses as cb
	left JOIN
		DIM_CommanderBonusType as bt
	on
		bt.BonusID = cb.BonusID
	and
	(
			cb.BonusID = 25
		or
			cb.BonusValue >= 1.2
	)
/*
4	Shipbuilding
5	Production
6	Mining
8	Population Growth
9	Terraforming
11	Ground Construction
14	Political Reliability
20	Wealth Creation
24	Logistics
25	Colony Administration
*/
	group by cb.CommanderID
) as cb on cb.CommanderID = cmd.CommanderID
left JOIN
	FCT_CommanderTraits as ct
on
	ct.CmdrID = cmd.CommanderID
left JOIN
	DIM_TraitsList as t
on
	t.TraitID = ct.TraitID
WHERE
	cmd.CommanderType = 2
AND
	cmd.CommandID = 0
AND
	cb.Bonuses like '%,%'
group by
	cb.CommanderID
order by 
	substr(cb.Bonuses,27) desc
	, cb.Bonuses desc
	, cmd.CommanderID

	
--order by 3 --cmd.Name