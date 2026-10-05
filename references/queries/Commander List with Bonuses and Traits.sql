WITH const AS 
(
	select
		--------------change the values in these lines as needed
		-- if you aren't playing the most recently created player race in the most recently created game in your database, use the approriate values in these two lines
		(select max(GameID) from FCT_Game) as GameID
		,(select max(RaceID) from FCT_Race where NPR = 0) as RaceID
		--------------
)

SELECT
	cmd.Name	
	,cb.CommanderID
	,CASE
		when cmd.CommanderType = 0 then 'Naval'
		when cmd.CommanderType = 1 then 'Ground Force Commander'
		when cmd.CommanderType = 2 then 'Civilian Administrator'
		when cmd.CommanderType = 3 then 'Scientist'
		else 'Unknown CommanderType: ' || cmd.CommanderType
	end as CmdType
	,cb.Bonuses
	,group_concat('' || t.Name	, ', ') as Traits
	--,*
FROM
	const as c
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
group by
	cb.CommanderID
order by cb.CommanderID

	
--order by 3 --cmd.Name