select
	s.ShipName
	,ifnull(sh.cnt,0) as InternalDamageHistoryCount
	,case when sh2.cnt is null then 0 else 1 end as XOAssigned
	,case when sc.Crew > s.CurrentCrew then 1 else 0 end as MissingCrew
FROM
	FCT_Ship as s
left JOIN
(
	select
		sh.ShipID
		,count(*) as cnt
	from
		FCT_ShipHistory as sh
	WHERE
		sh.Description like '%internal damage suffered%'
	group by
		sh.ShipID
) as sh
on
	sh.ShipID = s.ShipID
left JOIN
(
	select
		sh.ShipID
		,count(*) as cnt
	from
		FCT_ShipHistory as sh
	WHERE
		sh.Description like '%assigned as Executive Officer%'
	group by
		sh.ShipID
) as sh2
on
	sh2.ShipID = s.ShipID
inner JOIN
	FCT_ShipClass as sc
on
	sc.ShipClassID = s.ShipClassID
WHERE
	s.GradePoints > 1000