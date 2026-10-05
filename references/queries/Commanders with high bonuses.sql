SELECT
	cd.Name
	,cd.CommanderID
	,cd.CommanderType
	,r.RankName
	,count(*)
FROM
	FCT_Commander as cd
inner join vw_const as c on c.RaceID = cd.RaceID
inner join FCT_Ranks as r on r.RankID = cd.RankID
inner JOIN FCT_CommanderBonuses as cb on cb.CommanderID = cd.CommanderID
where cb.BonusValue >= 1.2
group by cd.CommanderID
order by 5 desc